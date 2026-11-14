/**
 * Cut-off text peeks in place (2026-11-12, the user: "I want it to actually make the full
 * line expanded like what we did for side bar"). Hovering text the page cut off (an
 * ellipsis, a line clamp, or a column that clips it) lays one light pill exactly over that
 * text, same font on the same spot, grown out over its neighbours until the whole text
 * shows: one line while it fits the window, wrapped below that. It replaces the native
 * `title` tooltip such rows used: from the first hover on cut-off text, every `title` from the
 * hovered element to the page root is taken off (and put back when the pointer leaves), so no
 * dark box opens on top of it, and a title that only repeats its text is gone from the source
 * (tests/web/truncation-peek-guard.test.ts).
 *
 * A task row (`data-peek-row`) expands in place instead (2026-11-13, the user: "I want the
 * actually the task to expand to a full one"): with the pointer anywhere on it, the row itself
 * grows to show every text it cut off, wrapped inside its own width, and the rows below move
 * down (truncation-peek-row.ts); it closes when the pointer leaves.
 *
 * One capturing document listener serves every surface, so a new truncated row needs
 * nothing to get it. The pill takes no pointer events: the row under it keeps its clicks,
 * and so does the row below that it covers. `data-peek="off"` on an element or an ancestor
 * opts it out. Never on touch, while a button is held, or in an editable field.
 */
import '@/styles/truncation-peek.css';
import { PEEK_OPEN_MS, PEEK_PAD_X, placePeek, placeVertically } from './truncation-peek-place';
import { clippingAncestors } from './clip-ancestors';
import { collapseRow, expandRow, inListBelow, within, type RowMarks } from './truncation-peek-row';

/** How far up from the hovered node the cut-off text is looked for. */
const MAX_DEPTH = 6;

/** Fields show their own text (a value, not child nodes): never peeked. */
const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function optedOut(el: Element): boolean {
  return !!el.closest('[data-peek="off"], .truncation-peek, [contenteditable="true"], [contenteditable=""]');
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
/** At most this many texts of one row open at once (a title, its status line, its project). */
const MAX_ROW_HOSTS = 8;
/** A row opens once the pointer rests on it this long, so sweeping across rows moves nothing. */
const ROW_OPEN_MS = 140;
/** A row's own buttons (its ⋮ menu, Start, Close): over one the row keeps quiet, so the button shows. */
const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="checkbox"], input, select, textarea, summary';

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
  for (const el of Array.from(row.querySelectorAll<HTMLElement>('*'))) {
    if (out.length >= MAX_ROW_HOSTS) break;
    if (out.some((h) => h.contains(el))) continue;
    if (el.closest(PEEK_ROW_SELECTOR) !== row || optedOut(el) || el.isContentEditable || SKIP_TAGS.has(el.tagName)) continue;
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
  if (row) {
    const hosts = cutTextsIn(row);
    if (hosts.length) {
      const control = rowControl(target);
      const onOwnButton = control && row.contains(control) && !hosts.some((h) => control.contains(h) || h.contains(control));
      if (!onOwnButton) return { key: row, hosts };
      // A button of the row with cut text of its own (past the row's first few) still peeks that text.
      const own = findCutText(target);
      return own && control.contains(own) ? { key: own, hosts: [own] } : null;
    }
  }
  const host = findCutText(target);
  return host ? { key: host, hosts: [host] } : null;
}

const TYPE_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'color', 'fontVariantNumeric'] as const;

/**
 * What is being peeked: its titles are off from the first hover (a browser reads an element's
 * title for its tooltip right after the pointer event, so taking it off here means no tooltip
 * ever starts), and its pills are up once the hover intent ran out.
 */
interface Active {
  key: Element; hosts: HTMLElement[]; titles: Array<[Element, string]>; texts: string[]; timer: ReturnType<typeof setTimeout> | null;
  /** A task row: it expands in place (truncation-peek-row.ts) instead of showing pills. */
  row: boolean;
  pills: HTMLElement[];
  /** What expanding the row marked. */
  marked: RowMarks;
}

let active: Active | null = null;
let pointer: { x: number; y: number } | null = null;
/** The list a closing row scrolled back: its own scroll event is no reason to close anything. */
let ownScroll: Element | null = null;
/**
 * The open row the pointer just left. It closes in the same step as the next row opens, so the
 * list changes once per row and not twice (a close, then an open 140 ms later), or once the
 * pointer rested off it for LINGER_MS, or at once when the pointer left its list.
 */
let lingering: Active | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
const LINGER_MS = 220;

function noteOwnScroll(list: Element | null): void {
  if (!list) return;
  ownScroll = list;
  // Its scroll event comes within a frame or two; after that a scroll there is a person's.
  requestAnimationFrame(() => requestAnimationFrame(() => { if (ownScroll === list) ownScroll = null; }));
}

/** `keepPlace`: the rows under the pointer stay where they are (truncation-peek-row.ts). */
function closeLingering(keepPlace: boolean): void {
  if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
  const was = lingering;
  if (!was) return;
  lingering = null;
  if (keepPlace) noteOwnScroll(collapseRow(was.marked, was.key, pointer));
  else collapseRow(was.marked);
  putTitlesBack(was.titles);
}

/** The pointer left the open row `state`: it stays open a moment (see `lingering`). */
function linger(state: Active): void {
  closeLingering(true);
  lingering = state;
  const wait = () => {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      // A row about to open closes it itself, in its own step; a press holds it as it is.
      if (active?.timer || pressed) wait();
      else closeLingering(true);
    }, LINGER_MS);
  };
  wait();
}
let observer: MutationObserver | null = null;
// When the last peek went: one that comes right after it opens at once, as the next row does.
let lastHiddenAt = 0;
const REOPEN_AT_ONCE_MS = 250;

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
  close(false);
  closeLingering(false);
}

/** Ends the current peek. `keepPlace`: as closeLingering's. */
function close(keepPlace: boolean): void {
  if (!active) return;
  const was = active;
  active = null;
  if (was.timer) clearTimeout(was.timer);
  observer?.disconnect();
  for (const p of was.pills) p.remove();
  if (was.pills.length) lastHiddenAt = Date.now();
  if (keepPlace) noteOwnScroll(collapseRow(was.marked, was.key, pointer));
  else collapseRow(was.marked);
  putTitlesBack(was.titles);
}

type Box = { left: number; top: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** One pill over one cut-off text. `placed`: the row's pills so far, which it never covers. */
function renderPill(host: HTMLElement, grow: boolean, placed: Box[]): HTMLElement | null {
  if (!host.isConnected) return null;
  const cs = getComputedStyle(host);
  const hostRect = host.getBoundingClientRect();
  const text = contentRect(host);
  const pill = document.createElement('div');
  pill.className = 'truncation-peek';
  pill.setAttribute('aria-hidden', 'true');
  pill.dataset.testid = 'truncation-peek';
  for (const p of TYPE_PROPS) pill.style[p] = cs[p];
  for (const n of Array.from(host.childNodes)) pill.appendChild(n.cloneNode(true));
  pill.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  pill.querySelectorAll('[data-testid]').forEach((n) => n.removeAttribute('data-testid'));
  pill.querySelectorAll('[title]').forEach((n) => n.removeAttribute('title'));
  // Measured on one line first, out of sight.
  pill.style.visibility = 'hidden';
  pill.style.whiteSpace = 'nowrap';
  pill.style.left = '0px';
  pill.style.top = '0px';
  document.body.appendChild(pill);
  const natural = pill.scrollWidth - PEEK_PAD_X * 2;
  const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
  const visibleWidth = Math.max(0, Math.min(hostRect.right, clipRight(host)) - text.left);
  const minWidth = clamped ? host.clientWidth : visibleWidth;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const box = placePeek({ left: text.left, top: Math.max(hostRect.top + (parseFloat(cs.paddingTop) || 0), text.top) }, clamped ? Math.min(natural, host.clientWidth) : natural, minWidth, viewport);
  pill.style.whiteSpace = box.width - PEEK_PAD_X * 2 + 0.5 >= natural ? 'nowrap' : 'normal';
  pill.style.width = `${box.width}px`;
  let at = placeVertically(box, pill.offsetHeight, viewport.height);
  // A second text of the row on the same line as the first one's pill goes right after that
  // pill, or under it when the window has no room there.
  for (let round = 0; round < placed.length * 2; round++) {
    const prev = placed.find((p) => overlaps(at, p));
    if (!prev) break;
    const right = prev.left + prev.width + 4;
    at = right + at.width <= viewport.width - 8
      ? { ...at, left: right }
      : { ...at, top: prev.top + prev.height + 2 };
  }
  // Never past the window's bottom, even if that lays it over an earlier pill of the row.
  if (at.top + at.height > viewport.height - 8) at = placeVertically(at, at.height, viewport.height);
  pill.style.left = `${at.left}px`;
  pill.style.top = `${at.top}px`;
  // It opens from what the row showed: a clip that widens out from the cut.
  if (grow) pill.style.setProperty('--peek-from', `${Math.max(0, at.width - (visibleWidth + PEEK_PAD_X))}px`);
  else pill.dataset.instant = '';
  pill.style.visibility = '';
  placed.push(at);
  return pill;
}

function renderAll(state: Active, grow: boolean): void {
  if (state.row) {
    // The row just left closes in this same step: one change of the list, not two.
    closeLingering(true);
    state.marked = expandRow(state.key, state.hosts);
    return;
  }
  const placed: Box[] = [];
  for (const h of state.hosts) {
    const pill = renderPill(h, grow, placed);
    if (pill) state.pills.push(pill);
  }
  if (!state.pills.length) close(false);
}

/** The row it shows changed under the pointer (renamed, re-sorted, gone): the peek goes with it. */
function watchActive(): void {
  observer ??= new MutationObserver(() => {
    const a = active;
    if (a && (!a.key.isConnected || a.hosts.some((h, i) => !h.isConnected || h.isContentEditable || h.textContent !== a.texts[i]))) { close(!!a.row); if (a.row) settleSoon(); }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable'] });
}

function activate(key: Element, hosts: HTMLElement[], target: Element, now: boolean): void {
  close(false);
  // A row placed on its own (a calendar chip over the day's grid) would grow over its
  // neighbours: it shows pills instead.
  const row = key !== hosts[0] && key.matches(PEEK_ROW_SELECTOR) && !/^(absolute|fixed)$/.test(getComputedStyle(key).position);
  const state: Active = { key, hosts, titles: takeTitles(target, key !== hosts[0] ? key : undefined), texts: hosts.map((h) => h.textContent ?? ''), timer: null, row, pills: [], marked: [] };
  active = state;
  watchActive();
  if (now && !row) { renderAll(state, false); return; }
  state.timer = setTimeout(() => {
    if (active !== state) return;
    state.timer = null;
    if (key.matches(':hover')) renderAll(state, true);
    else close(false);
  }, row ? ROW_OPEN_MS : PEEK_OPEN_MS);
}

let downAt: { x: number; y: number } | null = null;

function onOver(e: PointerEvent): void {
  if (e.pointerType === 'touch') { hidePeek(); return; }
  // A press in progress: a click lands on the row as it is; a drag closes it (onMove).
  if (e.buttons !== 0) { if (active && !active.row) close(false); return; }
  pointer = { x: e.clientX, y: e.clientY };
  const target = e.target instanceof Element ? e.target : null;
  if (lingering && target) {
    // Back on the row just left: it is the open row again.
    if (lingering.key.contains(target)) {
      close(false);
      if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
      active = lingering;
      lingering = null;
      watchActive();
      return;
    }
    // Out of its list: closing it moves nothing under the pointer.
    if (!inListBelow(lingering.key, pointer) && !within(lingering.key, pointer)) closeLingering(false);
  }
  // On the open row, its own buttons included: it stays open (closing it would move the button
  // out from under the pointer and open it again).
  if (active?.row && target && active.key.contains(target)) {
    if (!rowControl(target)) active.titles.push(...takeTitles(target, active.key));
    return;
  }
  // Off an open row: it stays open a moment, and closes in the step the next one opens.
  if (active?.row && active.marked.length) {
    const was = active;
    active = null;
    observer?.disconnect();
    linger(was);
  }
  over(target);
}

/** What `target` peeks, now that the pointer is on it. */
function over(target: Element | null): void {
  if (pressed) return;
  // Still on the row that peeks, off its own buttons: nothing to scan again.
  const sameRow = active && target && active.key.matches(PEEK_ROW_SELECTOR) && target.closest(PEEK_ROW_SELECTOR) === active.key && !rowControl(target);
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
  if (!next || !target) { close(false); return; }
  // A pill already up moves to the next text at once; the first one waits a short intent.
  activate(next.key, next.hosts, target, !!active?.pills.length || Date.now() - lastHiddenAt < REOPEN_AT_ONCE_MS);
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
  const shown = [active?.key, lingering?.key].filter((r): r is Element => !!r);
  return shown.some((r) => t.contains(r) || r.contains(t));
}

function hideAndSettle(e?: Event): void {
  if (e?.type === 'scroll' && ownScroll && e.target === ownScroll) { ownScroll = null; return; }
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
  // A click on an open row keeps it as it is, so the click lands where it was aimed; a pill goes.
  // A row not open yet stays closed through the press, so the click lands where it was aimed.
  if (active && (!active.row || active.timer)) close(false);
}

function onMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  pointer = { x: e.clientX, y: e.clientY };
  if (pressed && e.buttons !== 0 && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) dragged = true;
}

function onUp(): void {
  if (!pressed) return;
  pressed = false;
  // After a drag the rows are where it dropped them: start over from what the pointer is on.
  if (dragged) { dragged = false; hidePeek(); settleSoon(); }
}

function onOut(e: PointerEvent): void {
  // Out of the window: nothing else will say the pointer left.
  if (!e.relatedTarget) hidePeek();
}

const MODIFIERS = new Set(['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']);
let installed = false;

/** Once per window, from main.tsx. */
export function installTruncationPeek(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerup', onUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onUp, { capture: true, passive: true });
  // Anything that starts an action ends the peek at once, before the action's own handlers.
  document.addEventListener('dragstart', hidePeek, { capture: true, passive: true });
  // A modifier held for a click (Cmd or Shift to select) is no action of its own.
  document.addEventListener('keydown', (e) => { if (!MODIFIERS.has(e.key)) hidePeek(); }, { capture: true, passive: true });
  // Anything that moves the page under the pointer ends it, and what the pointer rests on after peeks.
  document.addEventListener('wheel', hideAndSettle, { capture: true, passive: true });
  document.addEventListener('scroll', hideAndSettle, { capture: true, passive: true });
  window.addEventListener('resize', hideAndSettle);
  window.addEventListener('blur', hidePeek);
  document.addEventListener('visibilitychange', hidePeek);
}
