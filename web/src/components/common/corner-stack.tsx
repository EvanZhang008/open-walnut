/**
 * The one place where Walnut's own notices appear: one stack at the bottom left of the window,
 * just right of the sidebar's icon rail, one fixed width, floating over the page (2026-11-16, the
 * user: "in notificaiton side pannel and as notificaiton on bot let", "the notificaiton pill will
 * adopt the width based on other pannel on the right, I think not need, just show like noticiaton
 * overlap ... nice unified", and after it was put at the top by mistake: "I said this notification is bottom left,
 * bottom left, and you put it on top again" (translated from Chinese)).
 *
 * Every notice that pops up by itself goes through <CornerSlot order={...}>: it portals into one
 * fixed stack, so notices never cover one another and share one width, gap and order. A higher
 * `order` sits nearer the bottom edge, and more notices stack upward. Its width never depends on
 * a panel, a composer, a column or a sheet (corner-stack.css). It reads two things from the
 * page's left edge: the sidebar rail's right edge (its left edge sits 16px past it) and, while
 * the notification center is open, that panel's right edge instead, so it never covers that
 * list. On the phone the stack spans the top of the screen under the safe area
 * (phone-layout.css), clear of the chat composer at the bottom.
 *
 * It overlaps the page like a system notification, and what it covers can still be scrolled out
 * from under it: it measures how much of the window's bottom it takes now (from its own box only,
 * 0 while it covers nothing) and gives that much extra room at its end to each scroller whose CSS
 * rule asks for it (corner-stack-room.ts), so nothing moves when a notice comes or goes
 * (tests/e2e/browser/corner-stack-room.spec.ts finds a scroller that misses it, or anything that
 * moved). Nothing here reads a panel to do it.
 *
 * tests/web/corner-stack-guard.test.ts fails on a notice that places itself in a corner of the
 * window instead of coming here, and on this file reading a panel's or composer's geometry again.
 */
import { useContext, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PHONE_LAYOUT_QUERY } from '@/hooks/usePhoneLayout';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import '@/styles/corner-stack.css';
import { STACK_WIDTH_PX } from './corner-stack-width';
import { giveStackRoom } from './corner-stack-room';

/** Where each kind sits in the stack: higher is nearer the bottom edge (the corner). */
export const CORNER_ORDER = {
  /** NotificationToaster: Walnut's and plugins' toasts, permission prompts, reminders. */
  toasts: 10,
  /** Why an Ask here in Files or Changed opened no card (FileAskNotice). */
  fileAsk: 15,
  /** A board's move toasts (KanbanToasts), with their Undo and Complete buttons. */
  board: 20,
  /** A one-off line from a pop-out window (openPopout.ts). */
  flash: 25,
  /** A host's first connect running in the background (hosts/HostConnectCard.tsx): it stays
   *  for minutes, so it sits nearer the corner than the passing toasts, just above the approval card. */
  hostConnect: 28,
  /** Approval cards: a script waits on them, so they sit nearest the corner. */
  approvals: 30,
} as const;

const STACK_CLASS = 'corner-stack';

/** What the stack knows that its notices draw by: crowded (short forms), whether the open
 *  notification center lists the approvals (the approval card steps aside for it), and whether a
 *  page's own list of them is in sight. */
export interface CornerState { compact: boolean; approvalsListed: boolean; summaryInSight: boolean }
let cornerState: CornerState = { compact: false, approvalsListed: false, summaryInSight: false };
const stateListeners = new Set<() => void>();
function setCornerState(next: CornerState): void {
  if (next.compact === cornerState.compact && next.approvalsListed === cornerState.approvalsListed && next.summaryInSight === cornerState.summaryInSight) return;
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
let listening = false;
let roomObserver: ResizeObserver | null = null;
let roomWatched: HTMLDivElement | null = null;

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

/** A window this short keeps the stack to its short forms as soon as two kinds show. */
const SHORT_WINDOW_PX = 720;
/** Where a page's own content lives: the app's main area, or a full-screen sheet over it. */
const PAGE_AREA = '.main-content, .open-walnut-fullscreen';

/** The desktop sidebar (the icon rail) the stack sits right of: only one in the page's row. */
function inFlowSidebar(): Element | null {
  const el = document.querySelector('.app-shell > .sidebar');
  if (!el) return null;
  return getComputedStyle(el).position === 'fixed' ? null : el;
}

/**
 * What the stack reads from the page: its left edge, never a panel's width. The sidebar rail's
 * right edge, or the open notification center's (it lists the same news, so the stack moves
 * right of it, its width unchanged), the approval dialog (the card steps aside while it is open:
 * the dialog shows the same request), the phone's drawer, and how many kinds show (crowded:
 * short forms).
 */
function sync(): void {
  if (!stack) return;
  const center = document.querySelector('.notification-panel');
  const centerOpen = !!center && shown(center);
  // The notification center is the list of every notice: open, it lists the approvals too and opens
  // them, so the stack's card steps aside while it is there. A Needs you line on a page is a row
  // of that page's list, not a notice: the card still pops up with it, as on every other page.
  const approvalsListed = centerOpen && [...center!.querySelectorAll('[data-testid="approval-summary"]')].some(inSight);
  stack.classList.toggle('approvals-listed', approvalsListed);
  // The center lists every toast already; beside it the stack keeps only what it does not list.
  stack.classList.toggle('beside-center', centerOpen);
  // Just right of the sidebar's rail; open, right of the center so it never covers that list. A
  // window with no room for the stack's width there hides it (the center lists the same news).
  // Only then: anywhere else a notice that cannot be seen is a notice lost.
  const sidebar = inFlowSidebar();
  const railRight = sidebar ? Math.max(0, Math.round(sidebar.getBoundingClientRect().right)) : 0;
  const from = centerOpen ? Math.max(railRight, Math.round(center!.getBoundingClientRect().right)) : railRight;
  if (from > 0) stack.style.setProperty('--corner-stack-rail', `${from}px`);
  else stack.style.removeProperty('--corner-stack-rail');
  stack.classList.toggle('is-tucked', centerOpen && window.innerWidth - from < STACK_WIDTH_PX + 32);
  // A crowded stack takes the short forms: every kind at once, or two in a short window, would
  // stand over a third of the page. Counted by the kinds shown, never by the stack's own height,
  // so the short forms do not undo the very reason for them. The phone has its own rules.
  const phone = window.matchMedia(PHONE_LAYOUT_QUERY).matches;
  const kinds = ['.corner-slot-toasts', '.corner-slot-board', '.corner-slot-host-connect', '.corner-slot-approvals']
    .filter((sel) => { const el = stack!.querySelector(sel); return !!el && el.childElementCount > 0 && shown(el); }).length;
  const crowded = kinds >= 3 || (kinds >= 2 && window.innerHeight < SHORT_WINDOW_PX);
  const compact = !phone && crowded;
  stack.classList.toggle('is-compact', compact);
  // A page's own list of the approvals in sight (Home's Needs you line, the Org page's): the card
  // there keeps its short form, so one request does not show twice at full size.
  const summaryInSight = !approvalsListed && [...document.querySelectorAll(`${PAGE_AREA.split(', ').map((a) => `${a} [data-testid="approval-summary"]`).join(', ')}`)].some(inSight);
  setCornerState({ compact, approvalsListed, summaryInSight });
  // The phone's drawer is a layer over the page: the stack waits under it until it closes.
  stack.classList.toggle('under-drawer', phone && !!document.querySelector('.main-content[inert]'));
  const dialog = document.querySelector('.approval-dialog-overlay');
  const dialogOpen = !!dialog && shown(dialog);
  stack.classList.toggle('approval-dialog-open', dialogOpen);
  // An approval card in sight: the toasts with it keep to their title and buttons.
  stack.classList.toggle('has-approval', !approvalsListed && !dialogOpen && !!stack.querySelector('.corner-slot-approvals [data-testid="approval-card"]'));
  // Home's taskbar along the bottom of the page (SessionTaskbar.tsx): the stack stands on it, so
  // the chips of minimized sessions at its left stay in reach. From the taskbar's top edge, written
  // to the stack only.
  const bar = phone ? null : document.querySelector('.session-taskbar');
  const lift = bar && shown(bar) ? Math.max(0, Math.round(window.innerHeight - bar.getBoundingClientRect().top)) : 0;
  if (lift !== liftPx) {
    liftPx = lift;
    if (lift > 0) stack.style.setProperty('--corner-stack-lift', `${lift}px`);
    else stack.style.removeProperty('--corner-stack-lift');
  }
  publishRoom();
}

/** Air between the stack's top and what ends above it. */
const ROOM_AIR_PX = 8;
/** The stack's own margin from the window's top and bottom edges (corner-stack.css). */
const EDGE_PX = 16;
let publishedRoom = 0;
/** How far Home's taskbar lifts the stack now (sync). */
let liftPx = 0;

/**
 * How much of the window's bottom the stack covers now, given to the rules that ask for it
 * (corner-stack-room.ts) and shown on the stack as data-room for a test or a look in DevTools:
 * from its own box only, so it never reads (or follows) a panel. 0 while it covers nothing: empty (every
 * slot empty is a zero-height stack), hidden (tucked, under the phone's drawer), or on the phone,
 * where it sits at the top of the screen. Kept while an approval dialog hides it
 * (approval-dialog-open), on purpose: the dialog is modal, so nothing scrolls under it, and the
 * stack comes back the moment it closes; taking the room away and back would only clamp a list
 * scrolled to its end twice. Runs after every sync and on every change of the stack's own size (a
 * ResizeObserver: a toast coming, going, opening its details).
 */
function publishRoom(): void {
  if (!stack) return;
  // Taller than the window holds (a notice opened to its whole text in a short window): it scrolls
  // itself (is-overfull), so every notice's x stays in reach. Judged by its content's height, which
  // the cap leaves alone, so it never flips back and forth.
  const overfull = stack.childElementCount > 0 && !window.matchMedia(PHONE_LAYOUT_QUERY).matches
    && stack.scrollHeight > window.innerHeight - 2 * EDGE_PX - liftPx;
  stack.classList.toggle('is-overfull', overfull);
  const box = stack.getBoundingClientRect();
  const hidden = stack.classList.contains('is-tucked') || stack.classList.contains('under-drawer');
  const covers = box.height > 0 && !hidden && !window.matchMedia(PHONE_LAYOUT_QUERY).matches;
  const room = covers ? Math.max(0, Math.ceil(window.innerHeight - box.top)) + ROOM_AIR_PX : 0;
  // While it covers something every look gives it again: a box a route mounted since gets it too
  // (only a box whose value differs is written).
  if (room === publishedRoom && room === 0) return;
  publishedRoom = room;
  giveStackRoom(room);
  if (room > 0) stack.dataset.room = String(room);
  else delete stack.dataset.room;
}

let roomFrame = 0;
/** publishRoom on the next frame, once however many sizes changed before it. */
function publishRoomSoon(): void {
  if (roomFrame) return;
  roomFrame = requestAnimationFrame(() => { roomFrame = 0; publishRoom(); });
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
  if (!listening) {
    listening = true;
    window.addEventListener('resize', sync);
    // A click or a key is what opens and closes what the stack reads (the notification center, a
    // dialog, the phone's drawer): look again on the next frames, not at the next half-second tick.
    const soon = () => {
      if (!stack || stack.childElementCount === 0) return;
      requestAnimationFrame(() => { sync(); requestAnimationFrame(sync); });
      window.setTimeout(sync, 260);
    };
    window.addEventListener('pointerup', soon, true);
    window.addEventListener('keyup', soon, true);
    // While it holds anything, look again twice a second: the notification center comes and goes,
    // a page's list of approvals scrolls into sight (a few reads, no layout writes).
    window.setInterval(() => { if (stack && stack.childElementCount > 0) sync(); }, 500);
  }
  // The room it publishes follows its own size on the next frame, the last notice leaving (height
  // 0) too. Never inside the observer's callback: publishRoom toggles is-overfull, which changes
  // the very box observed, and a change there in the same pass is what a browser reports as
  // 'ResizeObserver loop completed with undelivered notifications' (as useTitleRowTight.ts).
  if (stack !== roomWatched && typeof ResizeObserver !== 'undefined') {
    roomObserver ??= new ResizeObserver(publishRoomSoon);
    roomObserver.disconnect();
    roomObserver.observe(stack);
    roomWatched = stack;
  }
  sync();
  return stack;
}

/** One kind of notice in the stack. */
export function CornerSlot({ order, className, children }: { order: number; className?: string; children: ReactNode }) {
  const host = cornerStackElement();
  // A notice raised inside a page that is not shown (Home stays mounted off its route) waits
  // there: the portal would otherwise carry it onto whatever page is on screen.
  const routeShown = useContext(RouteShownContext) !== false;
  // A kind coming or going changes what the stack counts (crowded): every render looks again.
  useLayoutEffect(() => { sync(); });
  if (!routeShown) return null;
  return createPortal(
    <div className={className ? `corner-slot ${className}` : 'corner-slot'} style={{ order }}>{children}</div>,
    host,
  );
}

/**
 * Scrolls what a notice is about out from under the stack when the stack covers it (a board's
 * card under its own "Moved" toast at the bottom left): the nearest scrollers above it move it up
 * clear of the stack, as far as they can.
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
