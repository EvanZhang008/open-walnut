/**
 * The kanban's toast queue (spec 8.1, G7, G14) as pure logic: the newest toast
 * on top, three in sight, the older ones folded into `+N more moves` (still
 * expandable), each with its own buttons and its own 8s timer, every timer
 * paused while the pointer is over the stack. No React, no timers of its own:
 * KanbanToasts.tsx runs the one timeout `nextDeadline` names. Unit-pinned in
 * tests/web/kanban-toasts.test.ts.
 */
import type { KanbanToast } from './kanban-contract';

export const TOAST_TTL_MS = 8_000;
export const TOASTS_VISIBLE = 3;
/** A runaway producer cannot grow the queue without bound; the oldest go first. */
export const TOASTS_MAX = 30;

export type KanbanToastItem = KanbanToast & { id: string };

/** The queue, newest first. */
export function pushToastItem(list: readonly KanbanToastItem[], toast: KanbanToastItem): KanbanToastItem[] {
  const rest = list.filter((t) => t.id !== toast.id);
  return [toast, ...rest].slice(0, TOASTS_MAX);
}

export function dismissToastItem(list: readonly KanbanToastItem[], id: string): KanbanToastItem[] {
  return list.some((t) => t.id === id) ? list.filter((t) => t.id !== id) : list as KanbanToastItem[];
}

/** What the stack shows: the newest three (all when expanded) and the fold line under them. */
export function foldToasts<T extends { id: string }>(list: readonly T[], expanded: boolean): { shown: T[]; folded: number; foldText: string } {
  if (expanded || list.length <= TOASTS_VISIBLE) return { shown: [...list], folded: 0, foldText: '' };
  const folded = list.length - TOASTS_VISIBLE;
  return { shown: list.slice(0, TOASTS_VISIBLE), folded, foldText: `+${folded} more ${folded === 1 ? 'move' : 'moves'}` };
}

// ── Timers: one clock per toast, all paused together while hovered ──

export interface ToastClock {
  /** ms left when paused or not started. */
  remaining: number;
  /** When it fires; null while paused. */
  deadline: number | null;
}

export type ToastClocks = Record<string, ToastClock>;

/** Clocks for the queue as it is now: a new toast starts its full ttl, a gone one is dropped. */
export function syncClocks(clocks: ToastClocks, list: readonly KanbanToastItem[], now: number, paused: boolean): ToastClocks {
  const out: ToastClocks = {};
  for (const t of list) {
    const prev = clocks[t.id];
    if (prev) { out[t.id] = prev; continue; }
    const ttl = t.ttlMs ?? TOAST_TTL_MS;
    out[t.id] = { remaining: ttl, deadline: paused ? null : now + ttl };
  }
  return out;
}

export function pauseClocks(clocks: ToastClocks, now: number): ToastClocks {
  const out: ToastClocks = {};
  for (const [id, c] of Object.entries(clocks)) {
    out[id] = c.deadline === null ? c : { remaining: Math.max(0, c.deadline - now), deadline: null };
  }
  return out;
}

export function resumeClocks(clocks: ToastClocks, now: number): ToastClocks {
  const out: ToastClocks = {};
  for (const [id, c] of Object.entries(clocks)) out[id] = c.deadline !== null ? c : { remaining: c.remaining, deadline: now + c.remaining };
  return out;
}

/** The ids whose time is up. */
export function expiredToasts(clocks: ToastClocks, now: number): string[] {
  return Object.entries(clocks).filter(([, c]) => c.deadline !== null && c.deadline <= now).map(([id]) => id);
}

/** The earliest running deadline, or null when every clock is paused (or none is left). */
export function nextDeadline(clocks: ToastClocks): number | null {
  let best: number | null = null;
  for (const c of Object.values(clocks)) if (c.deadline !== null && (best === null || c.deadline < best)) best = c.deadline;
  return best;
}

// ── A toast from a part that holds no toast API (a lane editor that just lost its lane) ──

/** Bubbles from the part to its Board pane; KanbanToasts in that pane shows it. */
export const KANBAN_TOAST_EVENT = 'kanban-toast';
export const KANBAN_PANE_SELECTOR = '[data-testid="task-board-pane"]';

/** Dispatches `toast` on the pane holding `from` (the element itself when there is no pane). */
export function emitKanbanToast(from: Element | null | undefined, toast: KanbanToast): boolean {
  if (!from || !from.isConnected || typeof CustomEvent === 'undefined') return false;
  const target = from.closest(KANBAN_PANE_SELECTOR) ?? from;
  target.dispatchEvent(new CustomEvent<KanbanToast>(KANBAN_TOAST_EVENT, { bubbles: true, detail: toast }));
  return true;
}
