/**
 * Where a dragged card lands (spec 8.1, 8.2), as pure logic: KanbanLanes.tsx
 * draws the drop line from the same answer it sends, so the line never lies.
 *
 * - Over a card: before it (pointer in its top half) or after it (bottom half).
 * - Over a lane head: first. Over a lane's empty area: last.
 * - A done kind lane has no order (G26): anywhere in it is the top.
 * - Cards a filter hides keep their place relative to the shown ones; the
 *   order sent is the lane's FULL order.
 *
 * The keyboard drag is a small state machine over the same lanes: left and
 * right change lane, up and down change position, the announcements are the
 * English sentences of 8.2. Unit-pinned in tests/web/kanban-dnd.test.ts.
 */
import type { BoardLaneKind } from '../../../../../src/core/boards/board-lanes';

export type DropTarget =
  | { type: 'card'; id: string; after: boolean }
  | { type: 'head' }
  | { type: 'end' };

export interface DropResult {
  /** The lane's full order after the drop (hidden cards included). */
  order: string[];
  /** The dragged card's index in `order`. */
  index: number;
  /** Where the line is drawn: before this shown card id, or null = after the last shown card. */
  lineBefore: string | null;
}

/** `order` without `id`, then `id` at `index` (clamped). */
export function insertAt(order: readonly string[], id: string, index: number): string[] {
  const rest = order.filter((x) => x !== id);
  const i = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, i), id, ...rest.slice(i)];
}

/**
 * The drop of `dragged` into a lane whose full order is `laneOrder` and whose
 * shown cards are `shown` (in order). `target` is what the pointer is over.
 */
export function dropInLane(
  laneOrder: readonly string[], shown: readonly string[], dragged: string, target: DropTarget, kind: BoardLaneKind | '',
): DropResult {
  const shownRest = shown.filter((x) => x !== dragged);
  if (kind === 'done') {
    return { order: insertAt(laneOrder, dragged, 0), index: 0, lineBefore: shownRest[0] ?? null };
  }
  const rest = laneOrder.filter((x) => x !== dragged);
  if (target.type === 'head') return { order: [dragged, ...rest], index: 0, lineBefore: shownRest[0] ?? null };
  if (target.type === 'end' || target.id === dragged || !rest.includes(target.id)) {
    // After the last SHOWN card (a hidden card after it stays after it).
    const last = shownRest[shownRest.length - 1];
    const at = last ? rest.indexOf(last) + 1 : rest.length;
    const order = [...rest.slice(0, at), dragged, ...rest.slice(at)];
    return { order, index: at, lineBefore: null };
  }
  const si = shownRest.indexOf(target.id);
  const beforeId = target.after ? shownRest[si + 1] ?? null : target.id;
  if (beforeId === null) {
    const at = rest.indexOf(target.id) + 1;
    return { order: [...rest.slice(0, at), dragged, ...rest.slice(at)], index: at, lineBefore: null };
  }
  const at = rest.indexOf(beforeId);
  return { order: [...rest.slice(0, at), dragged, ...rest.slice(at)], index: at, lineBefore: beforeId };
}

/** Before or after a card, from the pointer's y against the card's box. */
export function sideOf(pointerY: number, rect: { top: number; height: number }): boolean {
  return pointerY > rect.top + rect.height / 2;
}

/**
 * Among the shown cards' boxes (top to bottom), the card the pointer is
 * closest to and which side; null when the lane shows none.
 */
export function cardTargetAt(pointerY: number, boxes: ReadonlyArray<{ id: string; top: number; height: number }>): DropTarget {
  if (boxes.length === 0) return { type: 'end' };
  for (const b of boxes) {
    if (pointerY < b.top + b.height) return { type: 'card', id: b.id, after: sideOf(pointerY, b) };
  }
  return { type: 'end' };
}

// ── Keyboard drag (8.2) ──

export interface KeyLane {
  id: string;
  name: string;
  kind: BoardLaneKind | '';
  /** Shown card ids, in order. */
  shown: readonly string[];
  /** Full order, hidden cards included. */
  order: readonly string[];
}

export interface KeyDrag {
  taskId: string;
  title: string;
  fromLane: string;
  laneIndex: number;
  /** Position among the lane's shown cards without the dragged one (0 = top). */
  pos: number;
}

/** Shown cards of a lane, the dragged one left out. */
function slots(lane: KeyLane, taskId: string): string[] {
  return lane.shown.filter((x) => x !== taskId);
}

export function startKeyDrag(lanes: readonly KeyLane[], taskId: string, title: string): KeyDrag | null {
  const li = lanes.findIndex((l) => l.shown.includes(taskId));
  if (li < 0) return null;
  const pos = lanes[li].kind === 'done' ? 0 : lanes[li].shown.indexOf(taskId);
  return { taskId, title, fromLane: lanes[li].id, laneIndex: li, pos };
}

/** One arrow key. Unknown keys return the state unchanged. */
export function stepKeyDrag(state: KeyDrag, key: string, lanes: readonly KeyLane[]): KeyDrag {
  let { laneIndex, pos } = state;
  if (key === 'ArrowRight') laneIndex = Math.min(lanes.length - 1, laneIndex + 1);
  else if (key === 'ArrowLeft') laneIndex = Math.max(0, laneIndex - 1);
  else if (key === 'ArrowDown') pos += 1;
  else if (key === 'ArrowUp') pos -= 1;
  else return state;
  const lane = lanes[laneIndex];
  if (!lane) return state;
  if (laneIndex !== state.laneIndex && key !== 'ArrowDown' && key !== 'ArrowUp') {
    // Into another lane: the same row when it has one, else its end.
    pos = Math.min(state.pos, slots(lane, state.taskId).length);
  }
  const max = slots(lane, state.taskId).length;
  pos = lane.kind === 'done' ? 0 : Math.max(0, Math.min(pos, max));
  return { ...state, laneIndex, pos };
}

/** The keyboard drop as the same result a pointer drop gives. */
export function keyDropResult(state: KeyDrag, lanes: readonly KeyLane[]): DropResult & { lane: string } {
  const lane = lanes[state.laneIndex];
  const s = slots(lane, state.taskId);
  const target: DropTarget = lane.kind === 'done' ? { type: 'head' }
    : state.pos >= s.length ? { type: 'end' } : { type: 'card', id: s[state.pos], after: false };
  return { lane: lane.id, ...dropInLane(lane.order, lane.shown, state.taskId, target, lane.kind) };
}

/** 1-based position and the count it is out of, as the announcements say them. */
export function keyPosition(state: KeyDrag, lanes: readonly KeyLane[]): { position: number; of: number } {
  const lane = lanes[state.laneIndex];
  const n = slots(lane, state.taskId).length + 1;
  return { position: state.pos + 1, of: n };
}

export const announce = {
  picked: (title: string) => `Picked up ${title}.`,
  over: (title: string, lane: string, position: number, of: number) => `${title} is over ${lane}, position ${position} of ${of}.`,
  dropped: (title: string, lane: string, position: number) => `${title} dropped in ${lane}, position ${position}.`,
  cancelled: () => 'Move cancelled.',
};
