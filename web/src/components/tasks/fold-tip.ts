/**
 * The hint of a worker-fold control ([data-fold-tip]): shown the moment the pointer or keyboard
 * focus is on it, never a native title with its delay (2026-11-11: "立马就显示一个 hover over").
 * One fixed box on the body, placed above the control (below when there is no room) and kept inside
 * the window, so a narrow task column or its scroller never cuts it off.
 */
const SELECTOR = '[data-fold-tip]';
const GAP = 6;
const EDGE = 6;

let installed = false;
let box: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;
/** What opened the box: a pointer leaving hides only a hover's, a blur only a focus's. */
let source: 'hover' | 'focus' = 'hover';
let watch: number | null = null;
/** Where the pointer last was: WebKit sends no pointerout when the layout moves a control away. */
let px = -1;
let py = -1;

function hide(): void {
  anchor = null;
  if (box) box.hidden = true;
  if (watch !== null) { window.clearInterval(watch); watch = null; }
}

function place(el: HTMLElement): void {
  if (!box) {
    box = document.createElement('div');
    box.className = 'worker-fold-tip';
    box.setAttribute('role', 'tooltip');
    box.dataset.testid = 'worker-fold-tip';
    document.body.appendChild(box);
  }
  box.textContent = el.dataset.foldTip ?? '';
  box.hidden = false;
  const r = el.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - EDGE));
  const above = r.top - GAP - h;
  const top = above >= EDGE ? above : Math.min(r.bottom + GAP, window.innerHeight - h - EDGE);
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

/** The box follows its control: gone, emptied or (for a hover) no longer under the pointer, it
    hides; new words (React reuses the button that turns from take-out into put-back) or a new
    place, it redraws. */
function follow(): void {
  if (!anchor || !box) return;
  const words = anchor.dataset.foldTip ?? '';
  const r = anchor.getBoundingClientRect();
  if (!anchor.isConnected || !words || (r.width === 0 && r.height === 0)) { hide(); return; }
  // A hover's control moved out from under a still pointer (a row it added pushed it down).
  if (source === 'hover' && !(px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) { hide(); return; }
  place(anchor);
}

function show(el: HTMLElement, from: 'hover' | 'focus'): void {
  if (!el.dataset.foldTip) return;
  anchor = el;
  source = from;
  place(el);
  if (watch === null) watch = window.setInterval(follow, 150);
}

function tipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest(SELECTOR) as HTMLElement | null) : null;
}

/** Installs the one document listener set; safe to call from every control's render. */
export function installFoldTip(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointermove', (e) => { px = e.clientX; py = e.clientY; }, true);
  document.addEventListener('pointerover', (e) => {
    px = e.clientX; py = e.clientY;
    // A touch screen has no hover: its arrows always show and say what they do by their place.
    if (e.pointerType === 'touch') return;
    const el = tipOf(e.target);
    if (el && el !== anchor) show(el, 'hover');
  }, true);
  document.addEventListener('pointerout', (e) => {
    if (!anchor || source !== 'hover' || tipOf(e.target) !== anchor) return;
    const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
    if (!to || !anchor.contains(to)) hide();
  }, true);
  document.addEventListener('focusin', (e) => {
    const el = tipOf(e.target);
    if (el && el.matches(':focus-visible')) show(el, 'focus');
  }, true);
  document.addEventListener('focusout', (e) => { if (anchor && tipOf(e.target) === anchor) hide(); }, true);
  // A scroll (one a keyboard focus starts, or another pane's) moves the control: the box follows it.
  document.addEventListener('scroll', follow, true);
  window.addEventListener('blur', hide);
}
