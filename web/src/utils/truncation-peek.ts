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
import { collapseRow, expandRow, growsDown, within, type RowMarks } from './truncation-peek-row';
import { CONTROL, cutTextsIn, onTextOf, optedOut, PEEK_ROW_SELECTOR, peekTargetOf, rowControl } from './truncation-peek-find';

export { cutTextsIn, findCutText, isCut, PEEK_ROW_SELECTOR, peekTargetOf } from './truncation-peek-find';

/** A row opens once the pointer rests on it this long, so sweeping across rows moves nothing. */
const ROW_OPEN_MS = 140;

/** An open card that grows downward and holds `node`: it keeps open while the person works in it. */
function openDownHolding(node: EventTarget | Node | null): Active | null {
  if (!(node instanceof Node)) return null;
  for (const a of [active, lingering, ...held]) if (a?.marked.down && a.key.contains(node)) return a;
  return null;
}

/**
 * Whether the open card `a` stays through something that closes every other peek (the window
 * losing focus, a scroll, the pointer leaving the window): it grows downward, so it sits in its
 * list's flow and moves with it, and focus is in it (typing in its box) or, with `pointerToo`,
 * the pointer is still on it.
 */
function keeps(a: Active | null, pointerToo: boolean): boolean {
  return !!a?.marked.down && (a.key.contains(document.activeElement) || (pointerToo && !!pointer && within(a.key, pointer)));
}

/** Ends every peek but a card that `keeps`. */
function hidePeekUnless(pointerToo: boolean): void {
  if (!keeps(active, pointerToo)) close();
  if (!keeps(lingering, pointerToo)) closeLingering();
  if (!active && !lingering) closeHeld();
}

/** Whether `a` comes before `b` in the page, outside it: a card above another in its list. */
function precedes(a: Element, b: Element): boolean {
  return !a.contains(b) && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
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
/**
 * Cards that grow downward above the open one, still open, top first. Closing the card above as
 * the pointer reached the one below moved that one up from under the pointer (2026-11-20
 * review); they close together once the pointer is off the stack.
 */
let held: Active[] = [];

function shut(a: Active): void {
  if (a.timer) clearTimeout(a.timer);
  collapseRow(a.marked);
  putTitlesBack(a.titles);
}

function closeHeld(): void {
  const was = held;
  held = [];
  for (const a of was.reverse()) shut(a);
}

function closeLingering(): void {
  if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
  const was = lingering;
  if (!was) return;
  lingering = null;
  if (!active) { observer?.disconnect(); closeHeld(); }
  shut(was);
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
  closeHeld();
}

/** Ends the current peek without moving the list. */
function close(): void {
  if (!active) return;
  const was = active;
  active = null;
  if (!lingering) { observer?.disconnect(); closeHeld(); }
  shut(was);
}

/** Opens `state`. `atPointer`: it opens only if it is still under the pointer once what closes above it moved it. */
function renderAll(state: Active, atPointer = true): void {
  const was = lingering;
  if (was?.marked.down && growsDown(state.key) && precedes(was.key, state.key)) {
    // The card above stays open: closing it now would move this one up from under the pointer.
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    lingering = null;
    held.push(was);
  } else {
    // A card that grew downward above it closes first and may move it from under the pointer.
    const shifts = !!was?.marked.down || held.length > 0;
    closeLingering();
    closeHeld();
    if (shifts && atPointer && pointer && !within(state.key, pointer)) { close(); settleSoon(); return; }
  }
  state.marked = expandRow(state.key, state.hosts);
}

/**
 * The open row's texts changed while it stays under the pointer (a status push re-rendered it, a
 * late markdown pass replaced its nodes): measure the original box and widen its new text in
 * the same task. No painted frame changes height or moves a neighbour. False when it no longer
 * has cut-off text there; then it is closed.
 */
function reopenInPlace(a: Active): boolean {
  // Still being read (the pointer on it) or worked in (focus in its box).
  const here = (!!pointer && within(a.key, pointer)) || a.key.contains(document.activeElement);
  if (!a.key.isConnected || !a.marked.length || !here) return false;
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
    const changed = (state: Active) => state.hosts.some((h, i) => !h.isConnected || h.isContentEditable || h.textContent !== state.texts[i]);
    held = held.filter((h) => h.key.isConnected || (shut(h), false));
    // A card kept open for its focus opens its new text again, with its new cap.
    if (lingering && (!lingering.key.isConnected || moved(lingering) || (lingering.marked.down && changed(lingering) && !reopenInPlace(lingering)))) closeLingering();
    const a = active;
    if (!a) return;
    // React can move the same node without disconnecting it or changing any text. Its old
    // shell must go immediately; settle on whatever is now under the pointer at the new order.
    if (!a.key.isConnected || moved(a)) { close(); settleSoon(); return; }
    if (!changed(a)) return;
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
    if (key.matches(':hover') || (keyboard && key.contains(document.activeElement))) renderAll(state, !keyboard);
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
  const up = target ? held.findIndex((h) => h.key.contains(target)) : -1;
  if (up >= 0) {
    // Back up on a card kept open above: it is the open one again; what is below it closes,
    // which moves nothing above it.
    const below = [active, lingering, ...held.splice(up + 1).reverse()];
    const back = held.pop()!;
    active = null;
    lingering = null;
    if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
    for (const a of below) if (a) shut(a);
    active = back;
    watchActive();
    return;
  }
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
    // A card that grows downward closes on its own clock: closing it now would move what is below
    // it, the row the pointer is reaching included.
    if (!within(lingering.key, pointer) && !lingering.marked.down) closeLingering();
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
  const shown = [active, lingering, ...held].filter((a): a is Active => !!a);
  // A text of an open card that grows downward scrolls inside itself: reading on keeps it open.
  return shown.some(({ key: r, marked }) => t.contains(r) || (r.contains(t) && !(marked.down && t !== r)));
}

function hideAndSettle(e?: Event): void {
  if (e && e.type !== 'resize' && (pressed || !movesPeek(e.target))) return;
  // A card that grows downward moves with its list: it stays while the pointer or focus is on it
  // (a phone's keyboard opening resizes the window and scrolls the box into view).
  hidePeekUnless(true);
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
  if (!e.relatedTarget && e.pointerType !== 'touch') hidePeekUnless(false);
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
    // A press in a card that grows downward blurs its box with nothing to focus (WebKit focuses no
    // button it clicks; text takes no focus): closing it then would move the button from under
    // the press and lose the click. The pointer still on it keeps it; linger closes it later.
    const pressedIn = !!active?.marked.down && !!pointer && within(active.key, pointer);
    if (active && (!(next instanceof Element) || !active.key.contains(next))) { if (!pressedIn) hidePeek(); }
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
  // A card with focus in its box stays through a window switch.
  window.addEventListener('blur', () => hidePeekUnless(false));
  document.addEventListener('visibilitychange', () => hidePeekUnless(false));
  document.addEventListener('dragend', () => { releaseLostPress(); hidePeek(); settleSoon(); }, { capture: true, passive: true });
}
