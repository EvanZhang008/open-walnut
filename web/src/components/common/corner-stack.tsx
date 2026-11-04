/**
 * The one corner where Walnut's own notices appear: the bottom left of the page, just right of
 * the sidebar and the page's own left column (2026-11-04, the user: "can we be consistent all notification is bottom left";
 * toasts sat top right, approval cards bottom right, board toasts in their pane's bottom right).
 *
 * Every notice that pops up by itself goes through <CornerSlot order={...}>: it portals into one
 * fixed stack, so notices never cover one another, never cover the sidebar's bottom row (the
 * bell, the update dock, plugin status rows), and share one width, gap and order. A higher
 * `order` sits nearer the corner. On the phone the same stack sits under the top bar
 * (phone-layout.css), as its toasts always did.
 *
 * tests/web/corner-stack-guard.test.ts fails on a notice that places itself in a corner of the
 * window instead of coming here.
 */
import { useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PHONE_LAYOUT_QUERY } from '@/hooks/usePhoneLayout';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import '@/styles/corner-stack.css';

/** Where each kind sits in the stack: higher is nearer the corner. */
export const CORNER_ORDER = {
  /** NotificationToaster: Walnut's and plugins' toasts, permission prompts, reminders. */
  toasts: 10,
  /** A board's move toasts (KanbanToasts), with their Undo and Complete buttons. */
  board: 20,
  /** A one-off line from a pop-out window (openPopout.ts). */
  flash: 25,
  /** Approval cards: a script waits on them, so they sit nearest the corner. */
  approvals: 30,
} as const;

const STACK_CLASS = 'corner-stack';

/** What the corner knows that its notices draw by: lifted over a chat (short forms), and whether the
 *  open notification center lists the approvals (the approval card steps aside for it). */
export interface CornerState { compact: boolean; approvalsListed: boolean }
let cornerState: CornerState = { compact: false, approvalsListed: false };
const stateListeners = new Set<() => void>();
function setCornerState(next: CornerState): void {
  if (next.compact === cornerState.compact && next.approvalsListed === cornerState.approvalsListed) return;
  cornerState = next;
  for (const l of stateListeners) l();
}
export function useCornerState(): CornerState {
  return useSyncExternalStore(
    (l) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    () => cornerState,
  );
}
let stack: HTMLDivElement | null = null;
let watched: Element | null = null;
let observer: ResizeObserver | null = null;
let onResize: (() => void) | null = null;

/** The sidebar the stack keeps clear of: only the desktop one, which is part of the page's row. */
function inFlowSidebar(): Element | null {
  const el = document.querySelector('.app-shell > .sidebar');
  if (!el) return null;
  return getComputedStyle(el).position === 'fixed' ? null : el;
}

/** Shown on this page now (Home stays mounted under visibility: hidden off its route). */
function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  return check ? check.call(el, { visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden';
}

/** On screen and not covered or scrolled away: the top element at its middle is it. */
function inSight(el: Element): boolean {
  if (!shown(el)) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + Math.min(r.width / 2, 40);
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && el.contains(hit);
}

/** Narrowest the stack gets to stay beside a composer instead of rising over it. */
const MIN_BESIDE_PX = 280;
const FULL_WIDTH_PX = 380;
/** Where a page's own content lives: the app's main area, or a full-screen sheet over it. */
const PAGE_AREA = '.main-content, .open-walnut-fullscreen';

/** What the stack keeps clear of besides the sidebar and the page's left column: the
 *  notification center (it moves to its right), a chat's composer under it (it stays at the bottom, narrower, when there is room left
 *  of the composer, else it sits just above it), and the approval dialog (its approval card steps
 *  aside while that is open: the dialog shows the same request). */
function syncAround(columnRight: number): void {
  if (!stack) return;
  let left = columnRight + 16;
  let floor = 0;
  let right = window.innerWidth;
  // A full-screen sheet (a session or board opened full screen) is the page now: its bottom left.
  const sheet = [...document.querySelectorAll('.open-walnut-fullscreen')].find(shown);
  if (sheet) {
    const b = sheet.getBoundingClientRect();
    left = Math.round(b.left) + 16;
    floor = Math.max(0, Math.round(window.innerHeight - b.bottom));
    right = Math.round(b.right);
  }
  const center = document.querySelector('.notification-panel');
  const centerOpen = !!center && shown(center);
  // The notification center is the list of every notice: open, it lists the approvals too and opens
  // them, so the corner's card steps aside while it is there. A Needs you line on a page is a row
  // of that page's list, not a notice: the card still pops up beside it, as on every other page.
  const approvalsListed = centerOpen && [...center!.querySelectorAll('[data-testid="approval-summary"]')].some(inSight);
  stack.classList.toggle('approvals-listed', approvalsListed);
  if (centerOpen) left = Math.max(left, Math.round(center!.getBoundingClientRect().right) + 16);
  // The center lists every toast already; beside it the stack keeps only what it does not list.
  stack.classList.toggle('beside-center', centerOpen);
  let width = Math.min(FULL_WIDTH_PX, right - left - 16);
  let bottom = floor + 16;
  for (const el of document.querySelectorAll('.chat-input-container')) {
    // A composer under a full-screen sheet is not on the page now.
    if (!shown(el) || (sheet && !sheet.contains(el))) continue;
    // The composer with what sits on it (a session's note line above the box): one block.
    const r = (el.closest('.session-panel-input') ?? el).getBoundingClientRect();
    // Only a composer that really sits under the stack's column, at the bottom of the window.
    if (r.right <= left || r.left >= left + width || r.bottom < window.innerHeight - 240) continue;
    const beside = Math.floor(r.left - left - 12);
    if (beside >= MIN_BESIDE_PX) width = Math.min(width, beside);
    else {
      bottom = Math.max(bottom, Math.round(window.innerHeight - r.top + 8));
      // Over the composer, the box's own left edge is the stack's: one column with what it sits on.
      const box = el.getBoundingClientRect();
      if (box.left > left - 16 && box.left < left) left = Math.round(box.left);
    }
  }
  stack.style.setProperty('--corner-stack-left', `${left}px`);
  stack.style.setProperty('--corner-stack-width', `${Math.max(0, width)}px`);
  stack.style.setProperty('--corner-stack-bottom', `${bottom}px`);
  // No free room: lifted over a chat. Toasts go to short lines too (the phone has its own rules).
  const phone = window.matchMedia(PHONE_LAYOUT_QUERY).matches;
  const compact = bottom > floor + 16 && !phone;
  stack.classList.toggle('is-compact', compact);
  setCornerState({ compact, approvalsListed });
  // The phone's drawer is a layer over the page: the corner waits under it until it closes.
  stack.classList.toggle('under-drawer', phone && !!document.querySelector('.main-content[inert]'));
  const dialog = document.querySelector('.approval-dialog-overlay');
  const dialogOpen = !!dialog && shown(dialog);
  stack.classList.toggle('approval-dialog-open', dialogOpen);
  // An approval card in sight: the toasts above it keep to their title and buttons.
  stack.classList.toggle('has-approval', !approvalsListed && !dialogOpen && !!stack.querySelector('.corner-slot-approvals [data-testid="approval-card"]'));
  // A wide notification center can leave no room right of it; it lists the same news then.
  stack.classList.toggle('is-tucked', width < MIN_BESIDE_PX - 40);
}

/**
 * The page's own left columns beside the sidebar (Home's task panel, the Org list, the Settings
 * nav, Calendar's rail, the Notes tree, Mail's folders and its message list, a plugin's list):
 * full-height panes that start at the sidebar's edge or at the previous column's, together no
 * wider than half the window, each leaving the stack its full width on its right. Their bottom
 * rows are what the person works in, so the stack sits right of them. Read from the layout, so a
 * new page's column needs no listing here.
 */
function leftColumnRight(sidebarRight: number): number {
  let right = sidebarRight;
  const y = window.innerHeight - 60;
  for (let step = 0; step < 3; step++) {
    const from = right;
    for (const el of document.elementsFromPoint(from + 30, y)) {
      if (stack?.contains(el) || !el.closest('.main-content')) continue;
      const r = el.getBoundingClientRect();
      // From the edge before it, or just past a page's own margin (Calendar's rail starts 28px in).
      if (r.left > from + 40 || r.left < from - 8 || r.width < 120 || r.width > window.innerWidth * 0.45) continue;
      if (r.right > window.innerWidth - FULL_WIDTH_PX - 32 || (step > 0 && r.right > window.innerWidth * 0.5)) continue;
      if (r.height < window.innerHeight * 0.85) continue;
      right = Math.max(right, Math.round(r.right));
    }
    if (right === from) break;
  }
  return right;
}

/**
 * Room for the stack in what it covers, so it never hides the end of a page. On a computer: the
 * scrolling area under it (a chat's timeline, a note) gets that much more room at its end (an
 * ::after spacer, corner-stack.css, so no inline style another hook writes is touched), and its
 * last line scrolls clear above the stack. On the phone: the stack's height joins the bar's
 * (--phone-topbar-h), so the page and every layer start below it.
 */
let reserved: HTMLElement | null = null;

/** A scroller whose end can take the spacer: a column of blocks with no ::after of its own. */
function takesSpacer(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const column = cs.display === 'block' || cs.display === 'flow-root' || (cs.display.endsWith('flex') && cs.flexDirection === 'column');
  return column && (el === reserved || getComputedStyle(el, '::after').content === 'none');
}

function scrollerUnder(x: number, y: number): HTMLElement | null {
  for (const hit of document.elementsFromPoint(x, y)) {
    if (stack?.contains(hit) || !hit.closest(PAGE_AREA)) continue;
    for (let el: HTMLElement | null = hit as HTMLElement; el && el !== document.body; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return takesSpacer(el) ? el : null;
    }
    return null;
  }
  return null;
}

function release(): void {
  if (!reserved) return;
  delete reserved.dataset.cornerRoom;
  reserved.style.removeProperty('--corner-room');
  reserved = null;
}

function syncRoom(): void {
  if (!stack) return;
  const r = stack.getBoundingClientRect();
  const visible = stack.childElementCount > 0 && !stack.classList.contains('is-tucked') && !stack.classList.contains('under-drawer') && r.height > 0;
  const phone = window.matchMedia(PHONE_LAYOUT_QUERY).matches;
  // The phone: the approval line, which stays until it is answered, takes room under the bar, so it
  // never covers the page's first controls. A toast comes and goes by itself: it lies over the page
  // below that line, so the page does not jump down and back under the reader's finger.
  const kept = phone && visible ? stack.querySelector('.corner-slot-approvals') : null;
  const keptBox = kept && shown(kept) ? kept.getBoundingClientRect() : null;
  const top = keptBox ? Math.round(keptBox.bottom - r.top) + 16 : 0;
  if (document.documentElement.style.getPropertyValue('--corner-reserve-top') !== `${top}px`) {
    document.documentElement.style.setProperty('--corner-reserve-top', `${top}px`);
  }
  const scroller = !phone && visible ? scrollerUnder(r.left + 24, r.top + 4) : null;
  if (!scroller) { release(); return; }
  if (reserved !== scroller) release();
  // While the stack holds something the room only grows: a notice leaving (a toast's own time
  // running out) never moves the chat back down under the reader. It goes when the stack is empty.
  const held = reserved === scroller ? parseFloat(scroller.style.getPropertyValue('--corner-room')) || 0 : 0;
  const room = Math.max(held, Math.round(scroller.getBoundingClientRect().bottom - r.top + 8));
  if (room <= 0) { release(); return; }
  reserved = scroller;
  scroller.dataset.cornerRoom = '';
  if (scroller.style.getPropertyValue('--corner-room') !== `${room}px`) {
    // A chat read at its end stays at its end: the newest line moves up clear of the stack.
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
    scroller.style.setProperty('--corner-room', `${room}px`);
    if (atEnd) scroller.scrollTop = scroller.scrollHeight;
  }
}

function syncLeft(): void {
  if (!stack) return;
  const sidebar = inFlowSidebar();
  const sidebarRight = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().right)) : 0;
  syncAround(leftColumnRight(sidebarRight));
  syncRoom();
  if (sidebar !== watched) {
    observer?.disconnect();
    watched = sidebar;
    if (sidebar && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(syncLeft);
      observer.observe(sidebar);
    }
  }
}

/** The stack element, made once per window and kept for its life. */
export function cornerStackElement(): HTMLDivElement {
  if (stack && stack.isConnected) return stack;
  const found = document.querySelector<HTMLDivElement>(`body > .${STACK_CLASS}`);
  stack = found ?? document.createElement('div');
  if (!found) {
    stack.className = STACK_CLASS;
    stack.setAttribute('data-testid', 'corner-stack');
    document.body.appendChild(stack);
  }
  if (!onResize) {
    onResize = () => syncLeft();
    window.addEventListener('resize', onResize);
    // A click or a key is what opens and closes what the stack keeps clear of (the notification
    // center, a panel, a dialog): look again on the next frames, not at the next half-second tick.
    const soon = () => {
      if (!stack || stack.childElementCount === 0) return;
      requestAnimationFrame(() => { syncLeft(); requestAnimationFrame(syncLeft); });
      window.setTimeout(syncLeft, 260);
    };
    window.addEventListener('pointerup', soon, true);
    window.addEventListener('keyup', soon, true);
    // While it holds anything, look again twice a second: a composer grows as one types, a panel
    // opens or closes, the notification center comes and goes (a few rect reads, no layout writes).
    window.setInterval(() => {
      if (stack && stack.childElementCount > 0) syncLeft();
      else if (reserved || document.documentElement.style.getPropertyValue('--corner-reserve-top') !== '0px') syncRoom();
    }, 500);
  }
  syncLeft();
  return stack;
}

/** One kind of notice in the corner stack. */
export function CornerSlot({ order, className, children }: { order: number; className?: string; children: ReactNode }) {
  const host = cornerStackElement();
  // A notice raised inside a page that is not shown (Home stays mounted off its route) waits
  // there: the portal would otherwise carry it onto whatever page is on screen.
  const routeShown = useContext(RouteShownContext) !== false;
  // The sidebar may have mounted, been replaced or gone since the stack was made (a notice can
  // arrive before the shell mounts it), so every render looks again; a resize is observed.
  useLayoutEffect(() => { syncLeft(); });
  if (!routeShown) return null;
  return createPortal(
    <div className={className ? `corner-slot ${className}` : 'corner-slot'} style={{ order }}>{children}</div>,
    host,
  );
}

/**
 * Scrolls what a notice is about out from under the stack when the stack covers it (a board's
 * card under its own "Moved" toast): the nearest scrollers above it move it up clear of the
 * stack, as far as they can.
 */
export function keepClearOfCorner(el: Element | null | undefined): void {
  if (!el || !stack || stack.childElementCount === 0) return;
  const s = stack.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom) return;
  let by = Math.ceil(r.bottom - s.top + 12);
  for (let p = el.parentElement; p && p !== document.body && by > 0; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    const room = p.scrollHeight - p.clientHeight - p.scrollTop;
    if (room <= 0) continue;
    const step = Math.min(by, Math.floor(room));
    p.scrollTop += step;
    by -= step;
  }
}

/** For code outside React (a pop-out's flash line): append into the stack at `order`. */
export function appendToCornerStack(el: HTMLElement, order: number): void {
  el.classList.add('corner-slot');
  el.style.order = String(order);
  cornerStackElement().appendChild(el);
}
