/**
 * The history group's cap (spec 4.4). Typing `work` matched 99 history rows and
 * pushed the HOME FOLDERS group to y=3342px of a 323px list, so the folder the
 * user was looking for could not be seen. When a HOME FOLDERS group has rows,
 * history shows at most HISTORY_CAP rows and then ONE option row 'Show N more'
 * (arrow keys reach it, Enter or a click expands in place). Without home rows
 * there is no cap: the list is history only and nothing is hidden below it.
 *
 * The cap also follows the list's height: 8 rows plus the more row do not fit
 * above the HOME FOLDERS header in a 720px window (a list about 250px tall),
 * so the cap is the number of rows that do fit there, never more than 8 and
 * never fewer than 3 (historyCapFor, from measureHistoryCap).
 *
 * Pure apart from measureHistoryCap (a DOM read). Unit-tested in
 * tests/web/path-selector/history-cap.test.ts.
 */
import type { RankedItem, Section } from './ranking';

export const HISTORY_CAP = 8;
/** However short the list, history keeps this many rows (the folder the user typed for is usually one of them). */
export const HISTORY_CAP_MIN = 3;
const HISTORY_SECTION_ID = 'history';

/** What the cap is decided from, in px, measured with the list scrolled to its top. */
export interface HistoryCapMeasure {
  /** The list's visible height. */
  listHeight: number;
  /** List content top to the first history row's top (the note on top, the history label). */
  above: number;
  /** Row pitch (height plus gap) of each history row on screen now, in order. */
  rowHeights: readonly number[];
  /** Last history row's bottom to the HOME FOLDERS label's bottom (the more row, gaps, the label). */
  below: number;
}

/**
 * How many history rows fit above the HOME FOLDERS header: min(8, rows that
 * fit), floor 3. Rows beyond the measured ones are assumed to be as tall as
 * the average measured row. No measurement (nothing rendered yet) = 8.
 */
export function historyCapFor(m: HistoryCapMeasure | null): number {
  if (!m || !(m.listHeight > 0) || m.rowHeights.length === 0) return HISTORY_CAP;
  const room = m.listHeight - m.above - m.below;
  const avg = m.rowHeights.reduce((a, b) => a + b, 0) / m.rowHeights.length;
  let used = 0;
  let n = 0;
  while (n < HISTORY_CAP) {
    const h = n < m.rowHeights.length ? m.rowHeights[n] : avg;
    if (used + h > room + 0.5) break;
    used += h;
    n++;
  }
  return Math.max(HISTORY_CAP_MIN, n);
}

/**
 * Read the list for historyCapFor. null when there is nothing to decide (no
 * history rows or no HOME FOLDERS header on screen). With no more row yet (the
 * group is not capped), one row's height is added below: capping adds it.
 */
export function measureHistoryCap(list: HTMLElement): HistoryCapMeasure | null {
  const history = list.querySelector<HTMLElement>(`[data-section-id="${HISTORY_SECTION_ID}"]`);
  const homeLabel = list.querySelector<HTMLElement>('[data-section-id^="home:"] .sps-section-label');
  if (!history || !homeLabel) return null;
  const rows = Array.from(history.querySelectorAll<HTMLElement>('.sps-path-item:not(.sps-more-row)'));
  if (rows.length === 0) return null;
  const contentTop = list.getBoundingClientRect().top - list.scrollTop;
  const first = rows[0].getBoundingClientRect();
  const last = rows[rows.length - 1].getBoundingClientRect();
  const pitch = (last.bottom - first.top) / rows.length;
  let below = homeLabel.getBoundingClientRect().bottom - last.bottom;
  if (!history.querySelector('.sps-more-row')) below += pitch;
  return {
    listHeight: list.clientHeight,
    above: first.top - contentTop,
    rowHeights: rows.map(() => pitch),
    below,
  };
}

export function moreRowText(n: number): string {
  return `Show ${n} more`;
}

export function isMoreRow(item: RankedItem | undefined): boolean {
  return item?.source === 'more';
}

function moreRow(hostKey: string, n: number): RankedItem {
  return {
    cwd: '', host: hostKey === '__local__' ? null : hostKey, source: 'more', depth: 0,
    moreCount: n, quality: 'none', leafHit: false, frecency: 0,
  };
}

function hasHomeRows(sections: readonly Section[]): boolean {
  return sections.some((s) => s.id.startsWith('home:') && s.items.length > 0);
}

/**
 * Cap the history group when home folders follow it. `expanded` (the user
 * pressed 'Show N more' for this input) returns the sections unchanged.
 * The more row sits where the first hidden history row was, so the flat index
 * the user selected lands on that row once it expands. `cap` is historyCapFor's
 * answer (8 when nothing was measured).
 */
export function capHistorySections(sections: Section[], expanded: boolean, cap: number = HISTORY_CAP): Section[] {
  if (expanded || !hasHomeRows(sections)) return sections;
  const limit = Math.max(HISTORY_CAP_MIN, Math.min(HISTORY_CAP, Math.floor(cap)));
  let changed = false;
  const out = sections.map((s) => {
    if (s.id !== HISTORY_SECTION_ID || s.items.length <= limit) return s;
    changed = true;
    const hidden = s.items.length - limit;
    return { ...s, items: [...s.items.slice(0, limit), moreRow(s.hostKey, hidden)] };
  });
  return changed ? out : sections;
}
