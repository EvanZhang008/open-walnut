// Pure width math for the home-page session column strip.
// Extracted from MainPage.tsx so it can be unit-tested without React.
//
// WHY THIS EXISTS (the bug it fixes at the root):
//
// Column widths used to be ONE scalar, `colSplitPct` — column 0 got `pct`% and
// "the rest" got `100 - pct`%. That is only coherent for EXACTLY two columns:
// with three, every non-first column is handed `100 - pct`% each, so the strip
// sums past 100% (50 → 50/50/50 = 150%) and overflows. Any "3 panels" option
// built on the scalar ships a broken layout.
//
// So widths are now per-column WEIGHTS (percentages summing to 100). Any column
// count works, and dragging a divider is a local trade between its two
// neighbours only — every other column keeps its share, which is how every
// other splitter in the app behaves.

/**
 * Floor (%) a single column may shrink to on a drag, for a strip of `count` columns.
 *
 * It MUST scale with the count. A fixed 20% (the old 20/80 scalar clamp) is
 * unsatisfiable from 5 columns up — 5 × 20 = 100 leaves zero room to trade, and
 * 6 × 20 = 120 is not even reachable — so a fixed floor silently turns every
 * drag into a no-op once the user picks a custom count that high. Half the even
 * share is always satisfiable (count × floor < 100 for any count) and keeps the
 * familiar 20% floor for the 2-column case.
 */
export function minColPct(count: number): number {
  if (count <= 1) return 100;
  return Math.min(20, (100 / count) * 0.5);
}

const STORE_KEY = 'open-walnut-col-weights';
/** Pre-3-panel scalar: column 0's share of a two-column strip. */
const LEGACY_SCALAR_KEY = 'open-walnut-col-split';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Equal shares summing to exactly 100 — the remainder goes to the first column. */
export function evenWeights(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const weights = new Array<number>(count).fill(base);
  weights[0] += 100 - base * count;
  return weights;
}

/**
 * Coerce arbitrary stored data into exactly `count` weights summing to 100.
 *
 * A stored layout that is the wrong length, non-numeric, or violates the
 * per-column floor is reset rather than salvaged column-by-column: it can only
 * come from a hand-edited or older-schema value, and an even split is a
 * predictable recovery.
 */
export function normalizeWeights(input: unknown, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(input) || input.length !== count) return evenWeights(count);
  const nums: number[] = [];
  for (const v of input) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return evenWeights(count);
    nums.push(v);
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const scaled = nums.map((n) => (n / sum) * 100);
  const floor = minColPct(count);
  if (scaled.some((n) => n < floor - 0.01)) return evenWeights(count);
  return scaled;
}

/**
 * Drag the divider between column `boundary` and `boundary + 1` by `deltaPct`
 * of the strip's width. Only those two columns trade width; the total stays 100.
 * `deltaPct` is measured from the grab point (not per-frame), so a drag is
 * always recomputed from the weights captured at pointerdown.
 */
export function resizeAtBoundary(weights: number[], boundary: number, deltaPct: number): number[] {
  if (boundary < 0 || boundary + 1 >= weights.length) return weights;
  const left = weights[boundary];
  const right = weights[boundary + 1];
  const floor = minColPct(weights.length);
  // Nothing to trade: the pair is already at (or under) twice the floor.
  if (left + right - floor * 2 <= 0) return weights;
  const delta = Math.min(right - floor, Math.max(floor - left, deltaPct));
  const out = [...weights];
  out[boundary] = left + delta;
  out[boundary + 1] = right - delta;
  return out;
}

function parseStore(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the saved layout for a `count`-column strip. Layouts are stored PER COUNT
 * so opening a third panel doesn't stretch (and then permanently lose) the
 * two-column layout the user tuned — closing it restores the old one verbatim.
 */
export function loadColWeights(count: number, storage: ReadableStorage): number[] {
  if (count <= 0) return [];
  let saved: unknown;
  try {
    saved = parseStore(storage.getItem(STORE_KEY))[String(count)];
  } catch {
    saved = undefined;
  }
  if (saved !== undefined) return normalizeWeights(saved, count);
  if (count === 2) {
    // Migrate the scalar: it held column 0's share, column 1 got the remainder.
    try {
      const legacy = parseFloat(storage.getItem(LEGACY_SCALAR_KEY) ?? '');
      if (!Number.isNaN(legacy)) return normalizeWeights([legacy, 100 - legacy], 2);
    } catch { /* fall through to an even split */ }
  }
  return evenWeights(count);
}

/** Persist one count's layout, leaving the other counts' saved layouts intact. */
export function saveColWeights(weights: number[], storage: WritableStorage): void {
  if (weights.length === 0) return;
  try {
    const store = parseStore(storage.getItem(STORE_KEY));
    store[String(weights.length)] = weights.map((w) => Math.round(w * 10) / 10);
    storage.setItem(STORE_KEY, JSON.stringify(store));
  } catch { /* storage unavailable (private mode / quota) — layout just won't persist */ }
}

// ── Home's row: task panel | Quick question slot | session columns ──
// Width goes by what the user opened, never by a pane that merely stayed open
// (standard.md "Panes": "Width goes by content").

/**
 * The most the session-columns area may take (as % of the row it shares with the
 * Quick question slot) when the user opens that slot beside `count` columns: the
 * slot he just opened gets at least one column's share. One column used to keep its
 * 65% and leave the new slot a third of the row beside an old session (2026-11-21
 * audit). Columns already narrower than that keep the width they have.
 */
export function sessionAreaPctBesideChat(count: number): number {
  if (count <= 0) return 0;
  return (100 * count) / (count + 1);
}

// Session-area width (%) by column count. 65% is the practical max alongside a readable
// chat column; from 3 columns up it takes the whole 70% the resizable panel allows
// (useResizablePanel's PANEL_PCT_MAX) or each column is unreadably thin. Counts past the
// end clamp to the last entry, so a custom count of 4-6 gets 70% too.
const SESSION_WIDTH_BY_COUNT = [0, 65, 65, 70];
export function sessionWidthForCount(count: number): number {
  return SESSION_WIDTH_BY_COUNT[Math.min(Math.max(count, 0), SESSION_WIDTH_BY_COUNT.length - 1)]!;
}

/**
 * The width the user chose for the session area, or null when it is the program's to size.
 * A drag marks its width (`dragged`). A stored width with no mark was kept by an older version,
 * which also stored the graduated width by itself on every column added: one of those exact
 * values (65, 70) was the program's; any other unmarked width is a drag, and stays his.
 */
export function usersSessionWidth(panel: { pct: number; custom: boolean; dragged: boolean }): number | null {
  if (panel.dragged) return panel.pct;
  if (!panel.custom) return null;
  return SESSION_WIDTH_BY_COUNT.includes(panel.pct) ? null : panel.pct;
}

/**
 * The Quick question slot beside the session columns: closed (or the phone's own layout), open on
 * a conversation with nothing in it yet (a new question's composer, a session with no history),
 * or open on one that has something to read.
 */
export type QuickQuestionSlot = 'closed' | 'empty' | 'shown';

/**
 * The session area's width as shown, derived from the layout on every render and never written
 * back (2026-11-22 review: two effects writing in turn missed the cap whenever Quick question
 * opened first, or was already open at a load, and a column added wiped a dragged width):
 * the user's own width as he left it; else the graduated width for the columns open, capped
 * beside a Quick question slot that shows a conversation so the slot gets at least one column's
 * share. An empty slot has nothing to read, so it keeps the smaller share the graduated width
 * leaves it and the columns keep their room (2026-11-22 audit: an empty CEO chat took half the
 * row and cut the title of the long session beside it).
 */
export function sessionAreaShownPct(userPct: number | null, count: number, slot: QuickQuestionSlot): number {
  if (userPct !== null) return userPct;
  const graduated = sessionWidthForCount(count);
  return slot === 'shown' && count > 0 ? Math.min(graduated, sessionAreaPctBesideChat(count)) : graduated;
}

/** The collapsed rail's width when `--home-rail-width` cannot be read (globals.css sets 56px). */
const HOME_RAIL_DEFAULT_PX = 56;

/** The task panel's least width: its toolbar's readable search, Display, More and Hide. */
export const TODO_PANEL_MIN_PX = 224;

/**
 * The task panel's CSS width for its stored share `pct`. The share is of the window
 * less the collapsed rail (`--home-rail-width` on `.main-page`), so it reads the same
 * as before with the rail collapsed, and expanding the sidebar takes its room from
 * the columns beside the panel, never from the task list. A plain `pct%` was a share
 * of Home's own width, which shrank with the sidebar and cut more of every row.
 * Never under TODO_PANEL_MIN_PX: 10% of a 1024 window was 102 px (2026-11-21), and the
 * panel and what is laid beside it read this one value.
 */
export function todoPanelWidth(pct: number): string {
  return `max(${TODO_PANEL_MIN_PX}px, (100vw - var(--home-rail-width, ${HOME_RAIL_DEFAULT_PX}px)) * ${Math.round(pct * 100) / 10000})`;
}

/** The room Home's empty pane needs for what it says (HomeEmptyPane: a 320px block and its padding). */
const HOME_EMPTY_PANE_PX = 400;
/** The widest the task panel grows by itself: a list keeps a readable line (`.page-readable`, 880px). */
const TASK_LIST_READABLE_PX = 880;

/**
 * The task panel's CSS width when nothing is open beside it (only Home's empty pane): the list
 * takes the room first and the empty pane keeps only what its words need (standard.md "Panes":
 * width goes by content; 2026-11-22 audit: the empty pane kept two thirds while long titles
 * wrapped in the panel). It grows to the window less the empty pane's room, up to a readable
 * line, and never below the width the panel has beside a session (`sharedPct`). A width the user
 * dragged in this layout (`alonePct`) is his; the layout with a session open keeps its own.
 */
export function todoPanelAloneWidth(alonePct: number | null, sharedPct: number): string {
  if (alonePct !== null) return todoPanelWidth(alonePct);
  const room = `calc(100vw - var(--home-rail-width, ${HOME_RAIL_DEFAULT_PX}px) - ${HOME_EMPTY_PANE_PX}px)`;
  return `max(${todoPanelWidth(sharedPct)}, min(${room}, ${TASK_LIST_READABLE_PX}px))`;
}

/**
 * What 100% of the task panel's share is, in px: the window less the collapsed rail, the same
 * room todoPanelWidth sizes it in, so a drag's px turn into the share the panel draws
 * (useResizablePanel's `basis`). `railPx` is the read `--home-rail-width`; NaN falls back.
 */
export function todoPanelBasisPx(viewportPx: number, railPx: number): number {
  return viewportPx - (Number.isFinite(railPx) ? railPx : HOME_RAIL_DEFAULT_PX);
}

// ── Floors: every column on Home's row keeps a readable width ──

/**
 * The narrowest a Home column (the Quick question slot, a session column) is drawn while the row
 * has room: the chat floor its header and composer need (2026-11-22: at 1280 with the task panel,
 * the Scratchpad, an empty Quick question and one session, Quick question got 145px, its header's
 * tools clipped and its name broke onto two lines).
 */
export const HOME_COLUMN_MIN_PX = 280;

/** The room Home's columns need at their floors: one per session column, one for an open Quick question. */
export function homeColumnFloorPx(columns: number, chatShown: boolean): number {
  return HOME_COLUMN_MIN_PX * (Math.max(0, columns) + (chatShown ? 1 : 0));
}

/**
 * The custom properties `.main-page-right` carries for the floors (globals.css, "Floors"), or none on a
 * phone, which shows one pane at a time. Who gives way when the row is short, in order: the session
 * area's share (Quick question keeps its floor), then the side bars (down to
 * globals.css --home-side-bar-floor); the task panel keeps the width the user gave it. A row that still
 * cannot hold every column at its floor (a hand-set count of many columns) splits what is left
 * evenly among the session columns, never cutting one off the window's edge.
 */
export function homeRowFloorVars(o: { columns: number; chatShown: boolean; sideBars: number; todoWidth: string | null; phone: boolean }): Record<string, string> | undefined {
  if (o.phone) return undefined;
  return {
    '--home-column-min': `${HOME_COLUMN_MIN_PX}px`,
    '--home-chat-min': o.chatShown ? `${HOME_COLUMN_MIN_PX}px` : '0px',
    '--home-columns': String(Math.max(1, o.columns)),
    '--home-row-floor': `${homeColumnFloorPx(o.columns, o.chatShown)}px`,
    '--home-side-bars': String(Math.max(0, o.sideBars)),
    '--home-todo-w': o.todoWidth ?? '0px',
  };
}
