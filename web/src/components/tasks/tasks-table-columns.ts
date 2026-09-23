/**
 * /tasks table column model — pure logic, no React.
 *
 * The table's grid is built from ONE list (`visibleColumns`): the header cells, the
 * row cells and the `grid-template-columns` tracks all map over the same array, so a
 * header/cell/track mismatch (the 2026-08 priority-column misalignment) cannot be
 * expressed. Title is always the first column and is not part of this model.
 *
 * Tested in tests/web/tasks-table-columns.test.ts.
 */
import type { TpSortKey } from './tasks-page-sort';
import { timeAgo } from '@/utils/time';

export type TpColumnId =
  | 'priority' | 'phase' | 'due' | 'start' | 'session' | 'project'
  | 'tags' | 'created' | 'updated' | 'completed';

export interface TpColumnDef {
  id: TpColumnId;
  label: string;
  /** CSS grid track for this column. */
  width: string;
  /** Header click sorts by this key; absent = plain (unsortable) header. */
  sortKey?: TpSortKey;
}

/** Every column the chooser can offer, in DISPLAY order (choosing never reorders). */
export const TP_COLUMNS: readonly TpColumnDef[] = [
  { id: 'priority', label: 'Priority', width: '120px', sortKey: 'priority' },
  { id: 'phase', label: 'Phase', width: '110px', sortKey: 'phase' },
  { id: 'due', label: 'Due', width: '90px', sortKey: 'due' },
  { id: 'start', label: 'Start', width: '90px', sortKey: 'start' },
  { id: 'session', label: 'Session', width: '170px', sortKey: 'session' },
  { id: 'project', label: 'Project', width: '140px', sortKey: 'project' },
  { id: 'tags', label: 'Tags', width: '160px' },
  { id: 'created', label: 'Created', width: '90px', sortKey: 'created' },
  { id: 'updated', label: 'Updated', width: '90px', sortKey: 'updated' },
  { id: 'completed', label: 'Completed', width: '100px', sortKey: 'completed' },
];

const COLUMN_IDS = new Set<string>(TP_COLUMNS.map((c) => c.id));

/**
 * The shipped layout: Title · Priority · Updated (2026-09-23, the user's pick after
 * a day with the chooser: "this should be default"). Priority is listed but only
 * drawn when `ui.show_priority` is on, so for most people this reads as Title ·
 * Updated: the list is a "what moved recently" view, and Due, Session and Project
 * are one click away in the chooser.
 */
export const TP_DEFAULT_COLUMNS: readonly TpColumnId[] = ['priority', 'updated'];

export const LS_TASKS_PAGE_COLUMNS = 'walnut-tasks-page-columns';

/** Title track — always first; the fluid column every other track is subtracted from. */
export const TITLE_TRACK = 'minmax(280px, 1fr)';

export function isColumnId(v: unknown): v is TpColumnId {
  return typeof v === 'string' && COLUMN_IDS.has(v);
}

/**
 * Parse a persisted column choice. Anything but a JSON array of known ids falls
 * back to the defaults; unknown ids inside a valid array are dropped (a column
 * retired in a later build must not wedge the whole choice), duplicates collapse,
 * and the result is normalized to display order.
 */
export function parseColumns(raw: string | null | undefined): TpColumnId[] {
  if (!raw) return [...TP_DEFAULT_COLUMNS];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [...TP_DEFAULT_COLUMNS];
    const chosen = new Set(v.filter(isColumnId));
    return TP_COLUMNS.filter((c) => chosen.has(c.id)).map((c) => c.id);
  } catch {
    return [...TP_DEFAULT_COLUMNS];
  }
}

export function serializeColumns(cols: readonly TpColumnId[]): string {
  return JSON.stringify(cols);
}

/** Add or remove one column, keeping display order. */
export function toggleColumn(cols: readonly TpColumnId[], id: TpColumnId): TpColumnId[] {
  const set = new Set(cols);
  if (set.has(id)) set.delete(id); else set.add(id);
  return TP_COLUMNS.filter((c) => set.has(c.id)).map((c) => c.id);
}

export interface ColumnScope {
  /** All Tasks view (the only place a PROJECT column means anything). */
  isAll: boolean;
  /** `ui.show_priority` — priority is drawn nowhere when this is off. */
  showPriority: boolean;
}

/** A column the chooser lists, and why it may be greyed out. */
export interface ColumnOffer {
  def: TpColumnDef;
  checked: boolean;
  /** Present = the row is listed but cannot be enabled here. */
  disabledReason?: string;
}

/** Whether a column can be drawn in this scope. */
export function columnAvailable(id: TpColumnId, scope: ColumnScope): boolean {
  if (id === 'project') return scope.isAll;
  if (id === 'priority') return scope.showPriority;
  return true;
}

/** The columns actually drawn: chosen ∩ available, in display order. */
export function visibleColumns(chosen: readonly TpColumnId[], scope: ColumnScope): TpColumnDef[] {
  const set = new Set(chosen);
  return TP_COLUMNS.filter((c) => set.has(c.id) && columnAvailable(c.id, scope));
}

/**
 * The chooser's rows. Project is simply absent outside All Tasks (a per-project
 * board has nothing to put there); Priority stays listed but disabled when the
 * app-wide flag is off, so the user learns where the switch lives instead of
 * concluding the column was removed.
 */
export function offerColumns(chosen: readonly TpColumnId[], scope: ColumnScope): ColumnOffer[] {
  const set = new Set(chosen);
  const out: ColumnOffer[] = [];
  for (const def of TP_COLUMNS) {
    if (def.id === 'project' && !scope.isAll) continue;
    const offer: ColumnOffer = { def, checked: set.has(def.id) };
    if (def.id === 'priority' && !scope.showPriority) {
      offer.disabledReason = 'Priority is turned off in Settings → Tasks';
    }
    out.push(offer);
  }
  return out;
}

/** `grid-template-columns` for the title track plus each visible column's track. */
export function gridTemplate(visible: readonly TpColumnDef[]): string {
  return [TITLE_TRACK, ...visible.map((c) => c.width)].join(' ');
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cell text for a timestamp column. Recent times read as an age ("3h ago") because
 * that is the question a Created/Updated column answers at a glance; older ones
 * switch to a short date, and add the year only when it differs from the current
 * one, so a two-year-old task is not mistaken for one from this spring.
 */
export function formatTableTime(iso: string | undefined | null, now: number = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '';
  if (now - t.getTime() < SEVEN_DAYS_MS) return timeAgo(iso, { now });
  const sameYear = t.getFullYear() === new Date(now).getFullYear();
  return t.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Tooltip for a timestamp cell: the full local date and time. */
export function formatTableTimeTitle(iso: string | undefined | null): string {
  if (!iso) return '';
  const t = new Date(iso);
  return isNaN(t.getTime()) ? '' : t.toLocaleString();
}
