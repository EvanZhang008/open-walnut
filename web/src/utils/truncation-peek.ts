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
 * One capturing document listener serves every surface, so a new truncated row needs
 * nothing to get it. The pill takes no pointer events: the row under it keeps its clicks,
 * and so does the row below that it covers. `data-peek="off"` on an element or an ancestor
 * opts it out. Never on touch, while a button is held, or in an editable field.
 */
import '@/styles/truncation-peek.css';
import { PEEK_OPEN_MS, PEEK_PAD_X, placePeek, placeVertically } from './truncation-peek-place';

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
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX === 'visible') continue;
    const edge = a.getBoundingClientRect().right - (parseFloat(cs.borderRightWidth) || 0);
    if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') { right = Math.min(right, edge); continue; }
    // auto / scroll: the last edge that counts.
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
/** At most this many texts of one row peek at once (a title, its status line, its project). */
const MAX_ROW_HOSTS = 4;
/** A row's own buttons (its ⋮ menu, Start, Close): over one the row keeps quiet, so the button shows. */
const CONTROL = 'button, a[href], [role="button"], [role="menuitem"], [role="checkbox"], input, select, textarea, summary';

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
      const control = target.closest(CONTROL);
      const onOwnButton = control && control !== row && row.contains(control) && !hosts.some((h) => control.contains(h) || h.contains(control));
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
interface Active { key: Element; hosts: HTMLElement[]; titles: Array<[Element, string]>; texts: string[]; pills: HTMLElement[]; timer: ReturnType<typeof setTimeout> | null }

let active: Active | null = null;
let observer: MutationObserver | null = null;
// When the last peek went: one that comes right after it opens at once, as the next row does.
let lastHiddenAt = 0;
const REOPEN_AT_ONCE_MS = 250;

/** Takes every native title from the pointer's element to the root, and in the row, off while the pills show. */
function takeTitles(from: Element, row?: Element): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  const take = (a: Element) => {
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

export function hidePeek(): void {
  if (!active) return;
  const was = active;
  active = null;
  if (was.timer) clearTimeout(was.timer);
  observer?.disconnect();
  for (const p of was.pills) p.remove();
  if (was.pills.length) lastHiddenAt = Date.now();
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
  const placed: Box[] = [];
  for (const h of state.hosts) {
    const pill = renderPill(h, grow, placed);
    if (pill) state.pills.push(pill);
  }
  if (!state.pills.length) hidePeek();
}

function activate(key: Element, hosts: HTMLElement[], target: Element, now: boolean): void {
  hidePeek();
  const state: Active = { key, hosts, titles: takeTitles(target, key !== hosts[0] ? key : undefined), texts: hosts.map((h) => h.textContent ?? ''), pills: [], timer: null };
  active = state;
  // The row it shows changed under the pointer (renamed, re-sorted, gone): the pills go with it.
  observer ??= new MutationObserver(() => {
    const a = active;
    if (a && (!a.key.isConnected || a.hosts.some((h, i) => !h.isConnected || h.isContentEditable || h.textContent !== a.texts[i]))) hidePeek();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable'] });
  if (now) { renderAll(state, false); return; }
  state.timer = setTimeout(() => {
    if (active !== state) return;
    state.timer = null;
    if (key.matches(':hover')) renderAll(state, true);
    else hidePeek();
  }, PEEK_OPEN_MS);
}

function onOver(e: PointerEvent): void {
  if (e.pointerType === 'touch' || e.buttons !== 0) { hidePeek(); return; }
  // Still on the row that peeks, off its own buttons: nothing to scan again.
  const target = e.target instanceof Element ? e.target : null;
  const sameRow = active && target && active.key.matches(PEEK_ROW_SELECTOR) && target.closest(PEEK_ROW_SELECTOR) === active.key && !target.closest(CONTROL)?.matches(':not([data-peek-row])');
  if (active && target && (sameRow || active.key === target || (active.hosts.length === 1 && active.hosts[0].contains(target)))) {
    active.titles.push(...takeTitles(target));
    return;
  }
  const next = peekTargetOf(e.target);
  if (active && next && next.key === active.key) {
    // The pointer moved onto a child that carries its own title: take that one off too.
    active.titles.push(...takeTitles(e.target as Element));
    return;
  }
  if (!next) { hidePeek(); return; }
  // A pill already up moves to the next row at once; the first one waits a short intent.
  activate(next.key, next.hosts, e.target as Element, !!active?.pills.length || Date.now() - lastHiddenAt < REOPEN_AT_ONCE_MS);
}

function onOut(e: PointerEvent): void {
  // Out of the window: nothing else will say the pointer left.
  if (!e.relatedTarget) hidePeek();
}

let installed = false;

/** Once per window, from main.tsx. */
export function installTruncationPeek(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  // Anything that moves rows or starts an action ends the pill at once, before the action's own handlers.
  for (const type of ['pointerdown', 'wheel', 'keydown', 'dragstart'] as const) document.addEventListener(type, hidePeek, { capture: true, passive: true });
  document.addEventListener('scroll', hidePeek, { capture: true, passive: true });
  window.addEventListener('resize', hidePeek);
  window.addEventListener('blur', hidePeek);
  document.addEventListener('visibilitychange', hidePeek);
}
