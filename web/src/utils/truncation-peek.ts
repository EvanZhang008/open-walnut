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
function isCut(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
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

const TYPE_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform', 'color', 'fontVariantNumeric'] as const;

/**
 * The cut-off text being peeked: its titles are off from the first hover (a browser reads an
 * element's title for its tooltip right after the pointer event, so taking it off here means
 * no tooltip ever starts), and its pill is up once the hover intent ran out.
 */
interface Active { host: HTMLElement; titles: Array<[Element, string]>; text: string; pill: HTMLElement | null; timer: ReturnType<typeof setTimeout> | null }

let active: Active | null = null;
let observer: MutationObserver | null = null;

/** Takes every native title from the pointer's element to the root off while the pill shows. */
function takeTitles(from: Element): Array<[Element, string]> {
  const out: Array<[Element, string]> = [];
  for (let a: Element | null = from; a; a = a.parentElement) {
    const t = a.getAttribute('title');
    if (t !== null) { out.push([a, t]); a.removeAttribute('title'); }
  }
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
  was.pill?.remove();
  putTitlesBack(was.titles);
}

function renderPill(state: Active, grow: boolean): void {
  const { host } = state;
  if (!host.isConnected) { hidePeek(); return; }
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
  const box = placePeek({ left: text.left, top: Math.max(hostRect.top + (parseFloat(cs.paddingTop) || 0), text.top) }, clamped ? Math.min(natural, host.clientWidth) : natural, minWidth, { width: window.innerWidth, height: window.innerHeight });
  pill.style.whiteSpace = box.width - PEEK_PAD_X * 2 + 0.5 >= natural ? 'nowrap' : 'normal';
  pill.style.width = `${box.width}px`;
  const placed = placeVertically(box, pill.offsetHeight, window.innerHeight);
  pill.style.left = `${placed.left}px`;
  pill.style.top = `${placed.top}px`;
  // It opens from what the row showed: a clip that widens out from the cut.
  if (grow) pill.style.setProperty('--peek-from', `${Math.max(0, placed.width - (visibleWidth + PEEK_PAD_X))}px`);
  else pill.dataset.instant = '';
  pill.style.visibility = '';
  state.pill = pill;
}

function activate(host: HTMLElement, target: Element, now: boolean): void {
  hidePeek();
  const state: Active = { host, titles: takeTitles(target), text: host.textContent ?? '', pill: null, timer: null };
  active = state;
  // The row it shows changed under the pointer (renamed, re-sorted, gone): the pill goes with it.
  observer ??= new MutationObserver(() => {
    const a = active;
    if (a && (!a.host.isConnected || a.host.isContentEditable || a.host.textContent !== a.text)) hidePeek();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['contenteditable'] });
  if (now) { renderPill(state, false); return; }
  state.timer = setTimeout(() => {
    if (active !== state) return;
    state.timer = null;
    if (host.matches(':hover')) renderPill(state, true);
    else hidePeek();
  }, PEEK_OPEN_MS);
}

function onOver(e: PointerEvent): void {
  if (e.pointerType === 'touch' || e.buttons !== 0) { hidePeek(); return; }
  const host = findCutText(e.target);
  if (active && host === active.host) {
    // The pointer moved onto a child that carries its own title: take that one off too.
    active.titles.push(...takeTitles(e.target as Element));
    return;
  }
  if (!host) { hidePeek(); return; }
  // A pill already up moves to the next row at once; the first one waits a short intent.
  activate(host, e.target as Element, !!active?.pill);
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
