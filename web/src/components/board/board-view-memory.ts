/**
 * The reader's view of each board, kept by the host so a new board document (every
 * leader write is one) opens as the last one was left: the scroll position (by an
 * anchor element, so content added above does not move the reader), which
 * <details> are open or closed, a thread the reader had scrolled up in, the strip filter and the
 * finished items they unfolded. The frame reports it (`wn-board:view`, board-runtime.frame.js)
 * and gets it back once, after its first data render.
 *
 * In memory, per page and per board owner: it outlives the Board pane (Files and
 * back, a hidden chat column), not a reload. The frame cannot keep it itself:
 * its opaque origin blocks sessionStorage and localStorage. `window.name` lasts
 * across documents in one frame but not into a new pane's frame, so it is kept
 * here too and given to the next frame as its `name` (the page's own scripts may
 * keep their state there). Pure; unit-pinned in tests/web/board-view-memory.test.ts.
 */

export interface BoardViewAnchor {
  path: string[];
  top: number;
}

export interface BoardView {
  v: 1;
  y: number;
  anchor: BoardViewAnchor | null;
  details: string[][];
  /** The <details> the reader closed (one the author writes open stays closed). */
  closed: string[][];
  threads: Record<string, { top: number }>;
  filter: string;
  folds: Record<string, true>;
  /** The frame's `window.name` (the page's own state, when it keeps one there). */
  name: string;
}

/** Bounds on what a frame may hand the host: it is the board author's page, not ours. */
export const BOARD_VIEW_MAX_ITEMS = 200;
export const BOARD_VIEW_NAME_MAX = 8192;
const PATH_MAX_PARTS = 64;
const PART_MAX = 200;
const MAX_BOARDS = 50;

const views = new Map<string, BoardView>();

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function path(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.length || v.length > PATH_MAX_PARTS) return null;
  const out: string[] = [];
  for (const part of v) {
    if (typeof part !== 'string' || !part || part.length > PART_MAX) return null;
    out.push(part);
  }
  return out;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** The frame's report, checked and bounded; null when it is not a view at all. */
export function parseBoardView(raw: unknown): BoardView | null {
  const o = record(raw);
  if (o.v !== 1) return null;
  const y = num(o.y);
  const a = record(o.anchor);
  const anchorPath = path(a.path);
  const anchorTop = num(a.top);
  const paths = (list: unknown): string[][] => {
    const out: string[][] = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (out.length >= BOARD_VIEW_MAX_ITEMS) break;
      const ok = path(p);
      if (ok) out.push(ok);
    }
    return out;
  };
  const details = paths(o.details);
  const closed = paths(o.closed);
  const threads: Record<string, { top: number }> = {};
  for (const [id, t] of Object.entries(record(o.threads)).slice(0, BOARD_VIEW_MAX_ITEMS)) {
    const top = num(record(t).top);
    if (id && id.length <= PART_MAX && top !== null && top >= 0) threads[id] = { top };
  }
  const folds: Record<string, true> = {};
  for (const [id, on] of Object.entries(record(o.folds)).slice(0, BOARD_VIEW_MAX_ITEMS)) {
    if (id && id.length <= PART_MAX && on === true) folds[id] = true;
  }
  return {
    v: 1,
    y: y !== null && y >= 0 ? y : 0,
    anchor: anchorPath && anchorTop !== null ? { path: anchorPath, top: anchorTop } : null,
    details,
    closed,
    threads,
    filter: typeof o.filter === 'string' && o.filter.length <= PART_MAX ? o.filter : '',
    folds,
    name: typeof o.name === 'string' ? o.name.slice(0, BOARD_VIEW_NAME_MAX) : '',
  };
}

/** Keep the frame's latest report for this board (an invalid one is dropped). */
export function keepBoardView(boardTaskId: string, raw: unknown): void {
  if (!boardTaskId) return;
  const view = parseBoardView(raw);
  if (!view) return;
  views.delete(boardTaskId); // re-insert: the map's order is the eviction order
  views.set(boardTaskId, view);
  while (views.size > MAX_BOARDS) views.delete(views.keys().next().value as string);
}

/** The view to restore on this board's next document, or null for a first visit. */
export function boardView(boardTaskId: string): BoardView | null {
  return views.get(boardTaskId) ?? null;
}

/** Test hook. */
export function _clearBoardViews(): void {
  views.clear();
}
